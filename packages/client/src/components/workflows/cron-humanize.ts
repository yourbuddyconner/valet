import cronstrue from 'cronstrue';

export function humanizeCron(expression: string): string | null {
  if (!expression || expression.trim() === '') return null;
  try {
    return cronstrue.toString(expression, { verbose: false, use24HourTimeFormat: false });
  } catch {
    return null;
  }
}
