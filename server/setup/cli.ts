/**
 * Linha de comando da preparação — chamada pelos scripts de duplo clique
 * (scripts/windows/setup.ps1, scripts/mac/setup.sh) e pelo CI.
 *
 *   tsx server/setup/cli.ts verificar [--json]
 *       Mostra o checklist. Sai 0 se o InHouse já pode ser usado, 1 se falta algo.
 *   tsx server/setup/cli.ts instalar [--itens node,git,claude,gh] [--simular]
 *       Instala o que falta (ou só os itens pedidos). --simular só mostra o plano.
 *       Sai 0 se tudo o que foi pedido ficou pronto.
 *
 * Login do Claude e nome/e-mail do Git ficam para a tela #/preparar.
 * Argumento inválido sai 2.
 */
import { aplicarAmbiente, pastaFerramentas } from "./ambiente.js";
import type { SetupItem, SetupItemId } from "../../shared/types.js";
import { zerarCacheClaudePath } from "../config.js";
import { zerarCacheGitBash } from "../platform.js";
import { detectarTudo, maquinaReal, prontoParaUsar } from "./detectar.js";
import { adquirirTrava, descreverPasso, ErroSetup, executarPasso, itemInstalavel, matarFilhosDoSetup, planejar, redeReal, rodarReal } from "./instalar.js";

const MARCA: Record<SetupItem["estado"], string> = {
  ok: "[ok]   ",
  aviso: "[aviso]",
  faltando: "[falta]",
  instalando: "[...]  ",
  verificando: "[...]  ",
  erro: "[erro] ",
};

function imprimir(itens: SetupItem[]): void {
  for (const it of itens) {
    const opc = it.obrigatorio ? "" : " (opcional)";
    console.log(`  ${MARCA[it.estado]} ${it.titulo}${opc}${it.detalhe ? ` — ${it.detalhe}` : ""}`);
  }
}

function sair(code: number, msg?: string): never {
  if (msg) (code === 0 ? console.log : console.error)(msg);
  process.exit(code);
}

interface Args {
  comando: "verificar" | "instalar";
  json: boolean;
  simular: boolean;
  itens?: SetupItemId[];
}

export function lerArgs(argv: string[]): Args | string {
  const [comando, ...resto] = argv;
  if (comando !== "verificar" && comando !== "instalar") return "Use: verificar [--json] | instalar [--itens a,b] [--simular]";
  const a: Args = { comando, json: false, simular: false };
  for (let i = 0; i < resto.length; i++) {
    const x = resto[i]!;
    if (x === "--json") a.json = true;
    else if (x === "--simular") a.simular = true;
    else if (x === "--itens" || x.startsWith("--itens=")) {
      const v = x.includes("=") ? x.slice(x.indexOf("=") + 1) : resto[++i];
      const ids = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const ruim = ids.find((id) => !itemInstalavel(id));
      if (!ids.length || ruim) return `Item desconhecido: ${ruim ?? "(vazio)"}. Use node, git, gitbash, claude ou gh.`;
      a.itens = ids as SetupItemId[];
    } else return `Opção desconhecida: ${x}`;
  }
  if (a.comando === "verificar" && (a.simular || a.itens)) return "verificar aceita só --json.";
  return a;
}

async function main(): Promise<void> {
  const args = lerArgs(process.argv.slice(2));
  if (typeof args === "string") sair(2, args);
  const m = maquinaReal();

  if (args.comando === "verificar") {
    const d = await detectarTudo(m);
    const pronto = prontoParaUsar(d.itens);
    if (args.json) console.log(JSON.stringify({ so: m.so, prontoParaUsar: pronto, itens: d.itens, identidade: d.identidade }, null, 2));
    else {
      console.log("Conferindo o que o InHouse precisa:");
      imprimir(d.itens);
      console.log(pronto ? "Tudo pronto para usar o InHouse." : "Falta preparar alguma coisa. Abra o InHouse para terminar.");
    }
    sair(pronto ? 0 : 1);
  }

  const antes = await detectarTudo(m);
  let passos;
  try {
    passos = planejar(antes.itens, m.so, args.itens, m.env);
  } catch (err) {
    sair(1, err instanceof Error ? err.message : String(err));
  }
  if (passos.length === 0) sair(0, "Programas prontos. Nada para instalar.");
  console.log(args.simular ? "Plano (simulação: nada é instalado):" : "Instalando:");
  passos.forEach((p, i) => console.log(`  ${i + 1}. ${descreverPasso(p, m.so)}`));
  if (args.simular) sair(0);

  const trava = adquirirTrava(pastaFerramentas(m.env, m.casa));
  if (!trava) sair(1, "Outra janela do InHouse está instalando. Espere ela terminar e tente de novo.");
  const encerrar = () => {
    matarFilhosDoSetup();
    trava.liberar();
    process.exit(130);
  };
  process.on("SIGINT", encerrar);
  process.on("SIGTERM", encerrar);

  let ultimaMsg = "";
  const rede = redeReal(m.env);
  try {
    for (const passo of passos) {
      try {
        const r = await executarPasso(passo, {
          m,
          rede,
          rodar: rodarReal,
          dormir: (ms) => new Promise((ok) => setTimeout(ok, ms)),
          progresso: (item, msg, pct) => {
            // Só mudanças de dezena, para não inundar o terminal.
            const texto = pct === undefined ? msg : msg.replace(/\d+%/, `${Math.floor(pct / 10) * 10}%`);
            const chave = `${item}:${texto}`;
            if (chave === ultimaMsg) return;
            ultimaMsg = chave;
            console.log(`     ${item}: ${texto}`);
          },
          log: (item, linha) => {
            if (process.env["INHOUSE_SETUP_VERBOSO"] === "1") console.log(`       ${item}| ${linha}`);
          },
        });
        console.log(`  [ok]    ${r}`);
      } catch (err) {
        const msg = err instanceof ErroSetup ? err.message : err instanceof Error ? err.message : String(err);
        sair(1, `  [erro]  ${msg}`);
      }
      aplicarAmbiente();
      zerarCacheClaudePath();
      zerarCacheGitBash();
    }
  } finally {
    trava.liberar();
  }

  const depois = await detectarTudo(m);
  const alvo = new Set(passos.flatMap((p) => p.itens));
  const resolvidos = depois.itens.filter((i) => alvo.has(i.id));
  imprimir(resolvidos);
  const falhou = resolvidos.filter((i) => i.estado !== "ok" && i.estado !== "aviso");
  if (falhou.length) sair(1, `Ainda falta: ${falhou.map((i) => i.titulo).join(", ")}.`);
  sair(0, "Programas prontos.");
}

const direto = process.argv[1] && /setup[\\/]cli\.(ts|js|mjs)$/.test(process.argv[1]);
if (direto) {
  main().catch((err: unknown) => {
    matarFilhosDoSetup();
    sair(1, `Não deu para preparar o computador: ${err instanceof Error ? err.message : String(err)}`);
  });
}
