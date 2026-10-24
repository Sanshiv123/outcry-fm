import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from '../secrets.ts';
import { env } from '../env.ts';
export class Store<T> {
  value: T;
  file: string;
  constructor(name: string, initial: T) {
    this.file = join(DATA_DIR, `${env.MOCK_MODE ? 'mock' : 'live'}-${name}.json`);
    this.value = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as T : initial;
  }
  save() {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.value), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
export const wire = new Store<{ time: string; operation: string; id?: string; status: string; simulated: boolean }[]>('wire', []);
export function logCall(operation: string, status: string, id?: string, simulated = env.MOCK_MODE) {
  wire.value.unshift({ time: new Date().toISOString(), operation, status, id, simulated });
  wire.value = wire.value.slice(0, 150); wire.save();
}
