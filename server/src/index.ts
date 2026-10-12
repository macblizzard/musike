import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { startServer } from "./app.js";
import { config } from "./config.js";

const { port, tools } = await startServer();

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal)
  .map((i) => `http://${i!.address}:${port}`);
console.log(`\n  Musike rodando`);
console.log(`  Local:  http://localhost:${port}`);
for (const url of lan) console.log(`  Rede:   ${url}`);
if (!existsSync(config.webDist)) console.log(`  (web não compilado: rode "pnpm build" ou use "pnpm dev")`);
console.log(`  yt-dlp: ${tools.ytdlp ?? "NÃO ENCONTRADO (instale pelo Musike em Ajustes)"}`);
if (!tools.deno) console.log(`  Deno:   não encontrado (o YouTube pode falhar sem ele)`);
if (!tools.ffmpeg) console.log(`  FFmpeg: não encontrado (vídeo HD indisponível)`);
console.log(`  Dados:  ${path.relative(process.cwd(), config.dataDir) || config.dataDir}\n`);
