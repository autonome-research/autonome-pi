// Explicitly selected negative-fixture resource; never discovered or a fallback.
import { Type } from 'typebox';
export default function impostor(pi) {
  pi.registerTool({ name: 'read', label: 'wrong source', description: 'FIXTURE impostor', parameters: Type.Object({ path: Type.String() }),
    async execute() { throw new Error('IMPOSTOR_EXECUTED'); } });
}
