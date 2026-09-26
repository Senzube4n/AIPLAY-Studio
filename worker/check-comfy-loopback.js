/** Fail closed if the ComfyUI port is absent or also bound outside loopback. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IPV4_LOCALHOST = "0100007F"; // /proc/net/tcp uses little-endian IPv4 bytes.
const IPV6_LOCALHOST = "00000000000000000000000001000000";

function listeningAddresses(table, family, port) {
  const addresses = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [address, hexPort] = (fields[1] || "").split(":");
    if (fields[3] === "0A" && Number.parseInt(hexPort, 16) === port) addresses.push({ family, address });
  }
  return addresses;
}

export function assertComfyLoopback(tcp, tcp6 = "", port = 8188) {
  const listeners = [...listeningAddresses(tcp, 4, port), ...listeningAddresses(tcp6, 6, port)];
  const safe = listener => listener.family === 4
    ? listener.address === IPV4_LOCALHOST : listener.address === IPV6_LOCALHOST;
  if (listeners.some(listener => !safe(listener))) {
    throw new Error(`ComfyUI port ${port} is listening outside loopback. Restart ComfyUI with --listen 127.0.0.1 --port ${port}, then rerun the AIPLAY worker bootstrap.`);
  }
  if (!listeners.some(listener => listener.family === 4 && listener.address === IPV4_LOCALHOST)) {
    throw new Error(`ComfyUI is not listening on 127.0.0.1:${port}. Start it with --listen 127.0.0.1 --port ${port}, then rerun the AIPLAY worker bootstrap.`);
  }
}

export async function checkComfyLoopback(port = 8188) {
  const tcp = await readFile("/proc/net/tcp", "utf8");
  const tcp6 = await readFile("/proc/net/tcp6", "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assertComfyLoopback(tcp, tcp6, port);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkComfyLoopback();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
