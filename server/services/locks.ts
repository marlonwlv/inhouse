/**
 * Serialização de operações git por projeto. Worktrees compartilham o .git do
 * checkout principal: publish + createEspaco (ou dois publish) em paralelo no
 * mesmo repositório colidem em index.lock/checkout. Uma promise-chain por
 * projeto garante uma operação de cada vez, sem dependências novas.
 */
const chains = new Map<string, Promise<unknown>>();

/** Executa `fn` quando as operações anteriores do mesmo projeto terminarem. */
export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // A cadeia guarda uma versão "sempre resolve" para o erro não contaminar o próximo.
  chains.set(
    projectId,
    next.catch(() => {}),
  );
  return next;
}
