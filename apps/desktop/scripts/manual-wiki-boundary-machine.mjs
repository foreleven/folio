/**
 * PROTOTYPE: evaluates the Git safety gates around a manually edited Task wiki.
 * It deliberately knows nothing about Agent, Skill, Integration, raws, UI, or persistence.
 */
export function boundaryState(facts) {
  const capture = !facts.runTerminal
    ? 'Run is not terminal'
    : !facts.writerStopped
      ? 'The writer is not confirmed stopped'
      : facts.sourceHead
        ? 'The source interval is already frozen'
        : !facts.taskDirty
          ? 'Task has no disk changes'
          : null
  const prepare = !facts.sourceHead ? 'No frozen Task source commit' : null
  const publish =
    facts.publishedHead && facts.prepared?.head === facts.publishedHead && facts.mainHead === facts.publishedHead
      ? null
      : !facts.prepared
        ? 'No canonical result is prepared'
        : facts.prepared.conflicted
          ? 'Canonical preparation still has conflicts'
          : facts.mainDirty
            ? 'Main has uncommitted disk changes'
            : facts.mainHead !== facts.prepared.base
              ? 'Main advanced after preparation'
              : null
  const align =
    facts.alignedTaskHead && facts.taskHead === facts.alignedTaskHead && !facts.taskDirty
      ? null
      : !facts.publishedHead
        ? 'Canonical result is not published'
        : facts.taskDirty
          ? 'Task has a newer disk draft'
          : facts.taskHead !== facts.acceptedTaskHead
            ? 'Task HEAD advanced after its source was frozen'
            : null
  return { capture, prepare, publish, align }
}
