/**
 * Usado pelo inhouse.cmd: espera o servidor do Inhouse responder e abre o
 * navegador padrão (equivalente ao `curl` + `open` do inhouse.command no Mac).
 */
import { spawn } from "node:child_process";

const porta = process.argv[2] || process.env.INHOUSE_PORT || "4400";
const url = `http://127.0.0.1:${porta}`;

for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (r.ok || r.status < 500) {
      // `start` é um comando interno do cmd.exe; o "" é o título da janela.
      spawn("cmd.exe", ["/d", "/c", "start", '""', url], { stdio: "ignore", windowsHide: true, detached: true }).unref();
      process.exit(0);
    }
  } catch {
    // ainda subindo
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`O Inhouse não respondeu em ${url}. Veja as mensagens na janela.`);
process.exit(1);
