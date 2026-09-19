// FIXTURE ONLY. Every provider response is local deterministic data, no external auth/API.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export const fixtureUsage = { input: 11, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const call = (name, args = {}, id = 'provider-reused-id') => ({ type: 'toolCall', id, name, arguments: args });
const plain = content => typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join('');
export default function provider(pi) {
  let turn = 0;
  pi.registerProvider('delegation-fixture', {
    baseUrl: 'https://fixture.invalid', apiKey: 'fixture-not-real-auth', api: 'delegation-fixture-stream',
    models: [{ id: 'deterministic', name: 'FIXTURE ONLY', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const config = JSON.parse(plain(context.messages.find(m => m.role === 'user').content));
          const snapshots = context.messages.filter(m => m.role === 'user' && plain(m.content).includes('pi-workflow-delegation-context/v1'));
          if (snapshots.length !== 1) throw new Error('FIXTURE_REQUIRED_CONTEXT');
          const snapshot = JSON.parse(plain(snapshots[0].content));
          const results = context.messages.filter(m => m.role === 'toolResult');
          const last = results.at(-1);
          const step = turn++;
          if (turn > 8) throw new Error('FIXTURE_TURN_LIMIT');
          process.stderr.write(JSON.stringify({ type: 'fixture_provider', depth: config.depth, turn,
            revision: snapshot.directoryRevision, index: snapshot.ownChildJoinIndex,
            tools: context.tools.map(t => t.name).sort(), lastTool: last?.toolName,
            lastError: last?.isError, sameConversationResult: last?.toolCallId,
            compacted: context.messages.some(m => plain(m.content ?? '').includes('FIXTURE_COMPACTION_SHAPE')) }) + '\n');
          const delegate = { directoryRevision: snapshot.directoryRevision, children: [{ label: 'child', task: 'fixture assignment',
            acceptance: [{ id: 'assignment', criterion: 'fixture criterion' }], agentBudget: 2 - config.depth,
            permissions: 'r', directoryScope: { read: ['allowed'], write: [] } }] };
          const complete = () => {
            let childReviews = [];
            if (last?.toolName === 'workflow_context') {
              const envelope = JSON.parse(plain(last.content));
              const index = JSON.parse(Buffer.from(envelope.page.data, 'base64').toString());
              childReviews = index.children.map(c => ({ childNodeId: c.childNodeId, resultHash: c.resultHash, decision: 'accepted', reason: 'fixture integrated' }));
            }
            return call('workflow_complete', { status: 'success', summary: `fixture depth ${config.depth} integrated`,
              acceptance: [{ id: 'assignment', outcome: 'passed', evidenceIds: [] }], evidence: [], childReviews, remainingWork: [] });
          };
          let content;
          if (config.mode.startsWith('mixed-') && step === 0) {
            const name = config.mode.split('-')[1];
            const exclusive = name === 'delegate' ? call('workflow_delegate', delegate) : name === 'complete' ? complete() : call('bash', { command: 'printf forbidden' });
            content = [call('write', { path: 'allowed/mutation', content: 'forbidden' }, 'sibling'), exclusive];
            if (config.mode === 'mixed-all') content = [content[0], call('workflow_delegate', delegate, 'd'), { ...complete(), id: 'c' }, call('bash', { command: 'printf forbidden' }, 'b')];
            if (config.mode.endsWith('-reverse')) content.reverse();
          } else if (config.mode === 'scope' && step === 0) {
            content = [call('grep', { path: 'allowed', pattern: 'NEEDLE', literal: true }, 'g1'),
              call('grep', { path: 'denied', pattern: 'NEEDLE', literal: true }, 'g2'),
              call('read', { path: 'allowed/link' }, 'r1'), call('read', { path: 'allowed/ok.txt' }, 'r2')];
          } else if (config.mode === 'shell' && step === 0) content = [call('bash', { command: 'printf fixture-shell', timeout: 1 })];
          else if (config.mode === 'schema-denial' && step === 0) content = [call('workflow_context', { view: 'bogus' })];
          else if (config.mode === 'schema-denial' && step === 1) content = [call('read', { path: 'allowed/input.txt' }, 'sd-read')];
          else if (config.mode === 'missing' || (config.mode === 'disconnect' && step > 0)) content = [{ type: 'text', text: 'fixture exits without completion' }];
          else if (['tree', 'disconnect'].includes(config.mode) && config.depth < 2 && step === 0) content = [call('workflow_delegate', delegate)];
          else if (config.mode === 'tree' && config.depth < 2 && step === 1) {
            content = [call('workflow_context', { view: 'artifact', artifactId: snapshot.ownChildJoinIndex.artifactId, limitBytes: 8192 })];
          } else content = [complete()];
          const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
            usage: fixtureUsage, stopReason: 'pending', timestamp: turn };
          stream.push({ type: 'start', partial: structuredClone(output) });
          content.forEach((part, contentIndex) => {
            output.content.push(part);
            if (part.type === 'toolCall') {
              stream.push({ type: 'toolcall_start', contentIndex, partial: structuredClone(output) });
              stream.push({ type: 'toolcall_end', contentIndex, toolCall: part, partial: structuredClone(output) });
            } else {
              stream.push({ type: 'text_start', contentIndex, partial: structuredClone(output) });
              stream.push({ type: 'text_delta', contentIndex, delta: part.text, partial: structuredClone(output) });
              stream.push({ type: 'text_end', contentIndex, content: part.text, partial: structuredClone(output) });
            }
          });
          output.stopReason = content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
          stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
        } catch (error) {
          const output = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
            usage: fixtureUsage, stopReason: 'error', errorMessage: String(error), timestamp: turn };
          stream.push({ type: 'error', reason: 'error', error: output }); stream.end();
        }
      });
      return stream;
    },
  });
}
