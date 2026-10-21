/** Peças comuns ao motor real e ao de demonstração da preparação. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoginGhStatus, SetupItemId, SetupStatus } from "../../shared/types.js";
import { DATA_DIR } from "../config.js";

export class ErroHttp extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface MotorSetup {
  status(forcar?: boolean): Promise<SetupStatus>;
  instalar(itens?: SetupItemId[]): Promise<SetupStatus>;
  iniciarLogin(): Promise<SetupStatus>;
  enviarCodigo(codigo: string): Promise<SetupStatus>;
  cancelarLogin(): Promise<SetupStatus>;
  /** Login do GitHub por código (gh auth login --web). */
  iniciarLoginGh(): Promise<SetupStatus>;
  cancelarLoginGh(): Promise<SetupStatus>;
  /** Avisa cada mudança do login do GitHub (o download espera por ele). Devolve o "parar de ouvir". */
  observarLoginGh(fn: (e: LoginGhStatus) => void): () => void;
  salvarIdentidade(nome: string, email: string): Promise<SetupStatus>;
  concluir(): Promise<SetupStatus>;
  ultimo(): SetupStatus | null;
  encerrar(): void;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Nome e e-mail do git: obrigatórios, sem quebra de linha, tamanho razoável. */
export function validarIdentidade(nome: unknown, email: unknown): { nome: string; email: string } {
  const n = typeof nome === "string" ? nome.trim() : "";
  const e = typeof email === "string" ? email.trim() : "";
  if (!n || n.length > 100 || /[\r\n<>]/.test(n)) throw new ErroHttp(400, "Escreva o seu nome (até 100 letras).");
  if (!EMAIL.test(e) || e.length > 200) throw new ErroHttp(400, "Esse e-mail não parece válido. Confira e tente de novo.");
  return { nome: n, email: e };
}

/** Código do login: uma linha, sem espaços nas pontas. */
export function validarCodigo(codigo: unknown): string {
  const c = typeof codigo === "string" ? codigo.trim() : "";
  if (!c || c.length > 2000 || /[\r\n]/.test(c)) throw new ErroHttp(400, "Cole o código inteiro que apareceu na página do Claude.");
  return c;
}

export function arquivoSetup(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, "setup.json");
}

export function lerConcluido(dataDir: string = DATA_DIR): string | undefined {
  try {
    const arq = arquivoSetup(dataDir);
    if (!existsSync(arq)) return undefined;
    const v = JSON.parse(readFileSync(arq, "utf8")) as { concluidoEm?: unknown };
    return typeof v.concluidoEm === "string" ? v.concluidoEm : undefined;
  } catch {
    return undefined;
  }
}

export function gravarConcluido(quando: string, dataDir: string = DATA_DIR): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(arquivoSetup(dataDir), JSON.stringify({ concluidoEm: quando }, null, 2));
}

export function mostrarAoAbrir(pronto: boolean, concluidoEm: string | undefined, temProjetos: boolean): boolean {
  return !pronto || (!concluidoEm && !temProjetos);
}
