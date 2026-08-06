/**
 * Helpers para rodar processos externos (git, npm, gh) sem shell.
 * Nunca usamos shell:true — argumentos sempre em array (segurança contra injeção).
 */
import { execFile } from "node:child_process";

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Padrão: 2 minutos. */
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Erro de processo com stdout/stderr preservados para diagnóstico. */
export class RunError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new RunError(`${cmd} ${args.join(" ")} falhou: ${stderr.trim() || err.message}`, stdout, stderr),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Roda git em `cwd` e retorna o stdout sem espaços nas pontas. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  // GIT_TERMINAL_PROMPT=0: o servidor não tem ninguém olhando o terminal — um
  // repositório privado sem credenciais deve falhar na hora, com erro claro,
  // em vez de travar esperando usuário/senha num prompt invisível.
  const { stdout } = await run("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

/** Como git(), mas retorna null em vez de lançar (para checagens opcionais). */
export async function tryGit(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}

/**
 * git commit com fallback de identidade: se a máquina não tem user.name/user.email
 * configurados, refaz o commit com a identidade padrão do builder (comum em
 * máquinas de quem não é dev).
 */
export async function gitCommit(cwd: string, message: string, extraArgs: string[] = []): Promise<void> {
  try {
    await git(cwd, "commit", "-m", message, ...extraArgs);
  } catch (err) {
    const texto = err instanceof RunError ? err.stderr + err.stdout : String(err);
    if (/user\.(name|email)|Please tell me who you are/i.test(texto)) {
      await git(
        cwd,
        "-c",
        "user.name=Inhouse",
        "-c",
        "user.email=inhouse@localhost",
        "commit",
        "-m",
        message,
        ...extraArgs,
      );
    } else {
      throw err;
    }
  }
}

/** Últimas `n` linhas de um texto (para mostrar erros sem despejar tudo). */
export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
}
