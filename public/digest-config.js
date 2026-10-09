export const DIGEST_MODE_LABELS = {
  sop_a_echo_marks: "基于标注消化",
  sop_b_ai_marks: "AI 先读先标注",
  discussion: "继续讨论",
  notion_route: "同步 Notion"
};

export const DIGEST_ACTIONS = [
  {
    label: "L1",
    mode: "sop_a_echo_marks",
    tooltip: DIGEST_MODE_LABELS.sop_a_echo_marks,
    instruction: DIGEST_MODE_LABELS.sop_a_echo_marks
  },
  {
    label: "L2",
    mode: "sop_b_ai_marks",
    tooltip: DIGEST_MODE_LABELS.sop_b_ai_marks,
    instruction: DIGEST_MODE_LABELS.sop_b_ai_marks
  }
];
