// Forwards 127.0.0.1:<port> inside a container to <host>:<port> (the hub on the machine running Docker).
// The CLI only accepts http:// for a hub on localhost, so the container sees the hub there.
// Usage: node hub-proxy.mjs <port> [host]
import net from "node:net";

const port = Number(process.argv[2] ?? 8797);
const host = process.argv[3] ?? "host.docker.internal";
net
  .createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  })
  .listen(port, "127.0.0.1", () => console.log(`hub proxy 127.0.0.1:${port} -> ${host}:${port}`));
