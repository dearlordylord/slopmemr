import { createServer } from "node:net"
createServer((socket) => socket.destroy()).listen(process.argv[2], () => process.stdout.write("ready\n"))
