import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionRequest, Project, Task, TranscriptItem } from "../shared/types.js";
import { isHumanStep } from "../shared/types.js";
import { DATA_DIR, TRANSCRIPTS_DIR, ensureDirs } from "./config.js";

interface State {
  projects: Project[];
  tasks: Task[];
}

const STATE_FILE = join(DATA_DIR, "state.json");

let state: State = { projects: [], tasks: [] };
/** Pedidos de permissão são efêmeros (não sobrevivem a restart — o claude filho já terá morrido). */
const permissions = new Map<string, PermissionRequest>();

export function load(): void {
  ensureDirs();
  if (existsSync(STATE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
      state = { projects: raw.projects ?? [], tasks: raw.tasks ?? [] };
      // Tarefas que estavam "rodando" quando o server caiu ficam pendentes de retry.
      // "Aguardando" num passo automático = esperava permissão (efêmera, Map em
      // memória): após o restart não há processo claude nem pedido vivo — vira retry.
      for (const t of state.tasks) {
        if (t.status === "rodando" || (t.status === "aguardando" && !isHumanStep(t.step))) {
          t.status = "falhou";
          t.error = "O Inhouse foi reiniciado no meio deste passo. Clique em Tentar de novo.";
        }
      }
    } catch {
      // estado corrompido: começa limpo, sem apagar o arquivo antigo
      renameSync(STATE_FILE, `${STATE_FILE}.corrupted-${Date.now()}`);
      state = { projects: [], tasks: [] };
    }
  }
}

function persist(): void {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

export const newId = (): string => randomUUID();

// ---------- Projects ----------
export const listProjects = (): Project[] => state.projects;
export const getProject = (id: string): Project | undefined =>
  state.projects.find((p) => p.id === id);
export function addProject(p: Project): Project {
  state.projects.push(p);
  persist();
  return p;
}
export function updateProject(id: string, patch: Partial<Project>): Project {
  const p = getProject(id);
  if (!p) throw new Error(`projeto não encontrado: ${id}`);
  Object.assign(p, patch);
  persist();
  return p;
}

// ---------- Tasks ----------
export const listTasks = (): Task[] => state.tasks;
export const getTask = (id: string): Task | undefined => state.tasks.find((t) => t.id === id);
export function addTask(t: Task): Task {
  state.tasks.push(t);
  persist();
  return t;
}
export function updateTask(id: string, patch: Partial<Task>): Task {
  const t = getTask(id);
  if (!t) throw new Error(`task não encontrada: ${id}`);
  Object.assign(t, patch, { updatedAt: new Date().toISOString() });
  persist();
  return t;
}
/** Próximo número de espaço livre no projeto (1-based, menor buraco disponível). */
export function nextEspaco(projectId: string): number {
  const used = new Set(
    state.tasks
      .filter((t) => t.projectId === projectId && t.status !== "concluida" && t.status !== "cancelada")
      .map((t) => t.espaco),
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// ---------- Permissions (efêmeras) ----------
export const listPermissions = (): PermissionRequest[] => [...permissions.values()];
export const getPermission = (id: string): PermissionRequest | undefined => permissions.get(id);
export function addPermission(p: PermissionRequest): PermissionRequest {
  permissions.set(p.id, p);
  return p;
}
export function removePermission(id: string): void {
  permissions.delete(id);
}

// ---------- Transcript ----------
// IDs locais são sempre randomUUID(); este guarda protege o SINK contra um
// taskId vindo de fora (ex.: import de eval de outra máquina) que tente escapar
// de TRANSCRIPTS_DIR com "../". Sem barras, sem pontos → sem path traversal.
function transcriptFile(taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new Error(`taskId inválido para transcript: ${taskId}`);
  }
  return join(TRANSCRIPTS_DIR, `${taskId}.jsonl`);
}
export function transcriptAppend(taskId: string, item: TranscriptItem): void {
  appendFileSync(transcriptFile(taskId), JSON.stringify(item) + "\n");
}
export function transcriptRead(taskId: string): TranscriptItem[] {
  const f = transcriptFile(taskId);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      // Linha corrompida (ex.: escrita interrompida por queda do servidor) é
      // pulada — não pode deixar o histórico inteiro da tarefa ilegível (500).
      try {
        return [JSON.parse(l) as TranscriptItem];
      } catch {
        return [];
      }
    });
}
