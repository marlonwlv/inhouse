#!/usr/bin/env node
/**
 * `npm run dev` / `npm run dev:fake` em qualquer SO. Antes as variáveis eram
 * definidas na sintaxe do sh (`VAR=x cmd`, `$HOME`), que o cmd.exe do Windows
 * não entende. Aqui elas saem do Node (os.homedir()) e o tsx roda pelo próprio
 * node — sem depender de shell nem de dependência nova (cross-env).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const modo = process.argv[2] ?? "dev";
const casa = homedir();
const perfis = {
  dev: {
    INHOUSE_DATA_DIR: join(casa, ".inhouse-dev"),
    INHOUSE_PROJECTS_DIR: join(casa, "Inhouse-dev"),
    INHOUSE_PORT: "4410",
  },
  fake: {
    INHOUSE_FAKE_MODEL: "1",
    INHOUSE_FAKE_DELAY_MS: "400",
    INHOUSE_EVAL_A_CADA: "1000000",
    INHOUSE_DATA_DIR: join(casa, ".inhouse-debug"),
    INHOUSE_PROJECTS_DIR: join(casa, "Inhouse-debug"),
  },
};
const perfil = perfis[modo];
if (!perfil) {
  console.error(`Modo desconhecido: ${modo} (use dev ou fake)`);
  process.exit(2);
}

// Mesmo efeito do `VAR=x cmd` antigo: o perfil sobrescreve o ambiente.
const env = { ...process.env, ...perfil };
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const filho = spawn(process.execPath, [tsx, "watch", "server/index.ts"], { stdio: "inherit", env });
for (const sinal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sinal, () => filho.kill(sinal));
filho.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
