// Confere se as dependências do InHouse estão em dia, sem rodar o npm.
// Sai 0 quando node_modules/.inhouse-deps bate com sha256(package-lock.json)
// + "-" + versão maior do Node (a mesma marca que o setup.sh e o setup.ps1
// gravam); sai 1 quando falta ou mudou (o InHouse foi atualizado, ou o Node).
// Usado pelo inhouse.command e pelo inhouse.cmd antes de abrir.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const lock = readFileSync(join(raiz, "package-lock.json"));
  const esperado = createHash("sha256").update(lock).digest("hex") + "-" + process.versions.node.split(".")[0];
  const marca = readFileSync(join(raiz, "node_modules", ".inhouse-deps"), "utf8").trim();
  process.exit(marca === esperado ? 0 : 1);
} catch {
  process.exit(1);
}
