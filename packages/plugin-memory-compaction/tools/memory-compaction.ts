export default async () => {
  return {
    "experimental.session.compacting": async (_input: unknown, output: { context: string[] }) => {
      output.context.push(
        "IMPORTANT: Preserve critical information in the compaction summary: " +
        "current task status, key decisions and reasoning, user preferences, " +
        "important file paths, and any bugs or constraints discovered. " +
        "Be thorough — anything not included will be lost permanently."
      );
    },
  };
};
