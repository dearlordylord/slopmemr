const report = (context, node, message) => {
  context.report({ node, message })
}

const reportRestricted = (context, node, message) => {
  const lines = context.sourceCode.text.split(/\r?\n/)
  const lineIndex = node.loc.start.line - 1
  const previousLine = lines[lineIndex - 1] ?? ""
  const currentLine = lines[lineIndex] ?? ""
  let nextLineSuppression = false
  for (let cursor = lineIndex - 1; cursor >= 0; cursor--) {
    const candidate = lines[cursor]?.trim() ?? ""
    if (candidate === "" || candidate === "(") continue
    nextLineSuppression = candidate.includes("eslint-disable-next-line") && candidate.includes("no-restricted-syntax")
    break
  }
  const prefix = lines.slice(0, lineIndex + 1).join("\n")
  const disableMatches = [...prefix.matchAll(/eslint-disable(?!-(?:line|next-line))[^\n]*no-restricted-syntax/g)]
  const enableMatches = [...prefix.matchAll(/eslint-enable[^\n]*no-restricted-syntax/g)]
  const lastDisable = disableMatches.at(-1)?.index ?? -1
  const lastEnable = enableMatches.at(-1)?.index ?? -1
  const suppressed =
    nextLineSuppression ||
    (previousLine.includes("eslint-disable-next-line") && previousLine.includes("no-restricted-syntax")) ||
    (currentLine.includes("eslint-disable-line") && currentLine.includes("no-restricted-syntax")) ||
    lastDisable > lastEnable
  if (!suppressed) report(context, node, message)
}

const memberName = (node) => {
  if (node.computed && node.property.type === "Literal") return node.property.value
  if (node.property.type === "Identifier") return node.property.name
  return undefined
}

const isIdentifier = (node, name) => node?.type === "Identifier" && node.name === name

const naturalKeyCollator = new Intl.Collator("en", { numeric: true })

const patternKey = (node) => {
  if (node.type === "RestElement") return { name: node.argument.name, order: 99 }
  if (node.type !== "Property" || node.computed) return undefined
  if (node.key.type === "Identifier") return { name: node.key.name, order: 1 }
  if (node.key.type === "Literal") return { name: String(node.key.value), order: 1 }
  return undefined
}

const containsIdentifier = (node, names) => {
  if (node === null || typeof node !== "object") return false
  if (node.type === "Identifier" && names.has(node.name)) return true
  return Object.entries(node).some(([key, value]) => {
    if (key === "parent" || key === "range" || key === "loc") return false
    if (Array.isArray(value)) return value.some((entry) => containsIdentifier(entry, names))
    return containsIdentifier(value, names)
  })
}

const sortablePattern = (node) => {
  const keys = node.properties.map(patternKey)
  if (keys.some((key) => key === undefined)) return undefined

  const boundNames = new Set(keys.map((key) => key.name))
  const orderSensitive = node.properties.some(
    (property) =>
      property.type === "Property" &&
      property.value.type === "AssignmentPattern" &&
      containsIdentifier(property.value.right, boundNames)
  )
  return orderSensitive ? undefined : keys
}

const sortDestructureKeys = {
  meta: { fixable: "code" },
  create: (context) => ({
    ObjectPattern: (node) => {
      const keys = sortablePattern(node)
      if (keys === undefined) return

      const indexed = node.properties.map((property, index) => ({ property, key: keys[index] }))
      const sorted = indexed.toSorted(
        (left, right) => left.key.order - right.key.order || naturalKeyCollator.compare(left.key.name, right.key.name)
      )
      const mismatch = indexed.findIndex((entry, index) => entry.property !== sorted[index].property)
      if (mismatch === -1) return

      context.report({
        node: indexed[mismatch].property,
        message: `Expected object destructuring keys to be sorted; ${sorted[mismatch].key.name} belongs before ${indexed[mismatch].key.name}.`,
        fix: (fixer) => {
          const source = context.sourceCode.text
          const separators = node.properties
            .slice(0, -1)
            .map((property, index) => source.slice(property.range[1], node.properties[index + 1].range[0]))
          const text = sorted
            .map(({ property }, index) => context.sourceCode.getText(property) + (separators[index] ?? ""))
            .join("")
          return fixer.replaceTextRange([node.properties[0].range[0], node.properties.at(-1).range[1]], text)
        }
      })
    }
  })
}

const noClockRead = {
  create: (context) => ({
    NewExpression: (node) => {
      if (isIdentifier(node.callee, "Date") && node.arguments.length === 0) {
        reportRestricted(
          context,
          node,
          "Zero-argument new Date() is banned. Use Effect DateTime.now or inject a clock."
        )
      }
    },
    CallExpression: (node) => {
      if (
        node.callee.type === "MemberExpression" &&
        isIdentifier(node.callee.object, "Date") &&
        memberName(node.callee) === "now"
      ) {
        reportRestricted(context, node, "Date.now() is banned. Use Effect Clock.currentTimeMillis or DateTime.now.")
      }
    }
  })
}

const noDoubleTypeAssertion = {
  create: (context) => ({
    TSAsExpression: (node) => {
      if (node.expression.type === "TSAsExpression") {
        reportRestricted(
          context,
          node,
          "Double type assertions require an explicit Oxlint suppression with justification."
        )
      }
    }
  })
}

const noSchemaPrimitive = {
  create: (context) => ({
    MemberExpression: (node) => {
      if (memberName(node) === "NonNegativeInt") {
        reportRestricted(context, node, "Use NonNegativeInteger from src/domain/schemas/shared.ts.")
      }
    },
    Property: (node) => {
      if (node.parent?.type === "ObjectPattern" && memberName({ ...node, property: node.key }) === "NonNegativeInt") {
        reportRestricted(context, node, "Do not destructure NonNegativeInt; use the shared NonNegativeInteger schema.")
      }
    }
  })
}

const forbiddenViMembers = new Set([
  "clearAllMocks",
  "doMock",
  "fn",
  "hoisted",
  "mock",
  "mocked",
  "spyOn",
  "stubGlobal",
  "unmock",
  "unstubAllGlobals"
])

const noTestMocks = {
  create: (context) => ({
    CallExpression: (node) => {
      if (node.callee.type !== "MemberExpression") return
      const name = memberName(node.callee)
      if (
        (isIdentifier(node.callee.object, "vi") && forbiddenViMembers.has(name)) ||
        (isIdentifier(node.callee.object, "jest") && name === "mock")
      ) {
        reportRestricted(
          context,
          node,
          "Test mocks are banned; substitute behavior through Effect layers or explicit ports."
        )
      }
    }
  })
}

const noTypeAssertion = {
  create: (context) => ({
    TSAsExpression: (node) => {
      const annotation = node.typeAnnotation
      const isConst = annotation.type === "TSTypeReference" && isIdentifier(annotation.typeName, "const")
      if (!isConst) {
        reportRestricted(context, node, "Type assertions are banned. Parse, use satisfies, or restructure the code.")
      }
    }
  })
}

const propertyTestPlacement = {
  create: (context) => {
    if (context.filename.includes(".property.test.") || context.filename.includes(".property.spec.")) return {}
    return {
      ImportDeclaration: (node) => {
        if (node.source.value === "fast-check") {
          report(context, node, "Property-based tests must live in *.property.test.ts files.")
        }
      },
      CallExpression: (node) => {
        if (
          node.callee.type === "MemberExpression" &&
          isIdentifier(node.callee.object, "fc") &&
          memberName(node.callee) === "property"
        ) {
          report(context, node, "Move fc.property tests to a *.property.test.ts file.")
        }
      }
    }
  }
}

const requireCanonicalEffectSchemaImport = {
  create: (context) => ({
    ImportDeclaration: (node) => {
      if (node.source.value !== "effect") return
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          reportRestricted(context, specifier, "Do not namespace-import Effect; import Schema by its canonical name.")
        }
        if (
          specifier.type === "ImportSpecifier" &&
          isIdentifier(specifier.imported, "Schema") &&
          !isIdentifier(specifier.local, "Schema")
        ) {
          reportRestricted(context, specifier, "Do not alias Schema imports from Effect.")
        }
      }
    }
  })
}

export default {
  meta: { name: "hulymcp" },
  rules: {
    "no-clock-read": noClockRead,
    "no-double-type-assertion": noDoubleTypeAssertion,
    "no-schema-primitive": noSchemaPrimitive,
    "no-test-mocks": noTestMocks,
    "no-type-assertion": noTypeAssertion,
    "property-test-placement": propertyTestPlacement,
    "require-canonical-effect-schema-import": requireCanonicalEffectSchemaImport,
    "sort-destructure-keys": sortDestructureKeys
  }
}
