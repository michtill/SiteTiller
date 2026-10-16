import { workflow as realWorkflow } from '../../src/workflow.ts';
// Workflow for tests whose model mocks were written before the final user answer existed: the separate
// final-answer call (client.textOnlyFinal) is answered here with the supplied outcome (summary and facts),
// so the mock sees only the agent calls it scripts and assertions on the reported outcome still hold.
export function withFinalAnswer(model: any) {
  return async (client: any, instructions: any, input: any, ...rest: any[]) => {
    if (!client?.textOnlyFinal) return model(client, instructions, input, ...rest);
    const { summary = '', facts = [] } = input?.outcome || {};
    const text = [summary, ...facts.map((fact: any) => (typeof fact === 'string' ? fact : JSON.stringify(fact)))]
      .filter(Boolean)
      .join('\n');
    return { value: { finalAnswer: text || 'Hotovo.' } };
  };
}
export function workflow(...args: Parameters<typeof realWorkflow>) {
  if (typeof args[5] === 'function') args[5] = withFinalAnswer(args[5]) as any;
  return realWorkflow(...args);
}
