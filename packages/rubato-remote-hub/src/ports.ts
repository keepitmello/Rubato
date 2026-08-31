import { createServer } from "node:net"

export async function findAvailableHubPort(preferred: number): Promise<number> {
  const candidates = [preferred, ...Array.from({ length: 85 }, (_value, index) => 7315 + index)].filter((port, index, all) => all.indexOf(port) === index)
  for (const port of candidates) if (await isAvailable(port)) return port
  throw new Error("no localhost Rubato Remote port available from 7314 through 7399")
}

function isAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}
