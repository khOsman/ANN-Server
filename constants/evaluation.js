export const FEEDBACK_OPTIONS = {
  needs_improvement: { label: "Needs Improvement", weight: 1 },
  average: { label: "Average", weight: 2 },
  good: { label: "Good", weight: 3 },
  excellent: { label: "Excellent", weight: 4 },
};

export const FEEDBACK_OPTION_KEYS = Object.keys(FEEDBACK_OPTIONS);
export const FEEDBACK_MAX_WEIGHT = 4;

export const RECOMMENDATION_OPTIONS = {
  do_not_recommend: { label: "Do not Recommend", weight: 1 },
  waiting: { label: "Waiting", weight: 2 },
  recommend: { label: "Recommend", weight: 3 },
  strongly_recommend: { label: "Strongly Recommend", weight: 4 },
};

export const RECOMMENDATION_OPTION_KEYS = Object.keys(RECOMMENDATION_OPTIONS);
export const RECOMMENDATION_MAX_WEIGHT = 4;

export const REQUIRED_EVALUATIONS = 3;

export const SELECTION_STATUS = {
  PENDING: "Pending",
  SELECTED: "Selected",
  WAITLISTED: "Waitlisted",
  REJECTED: "Rejected",
};

// BRAC's official Participant Selection rubric — 7 weighted criteria summing
// to 100, replacing the old manual 0-10 "FGD Score" field.
export const RUBRIC_CRITERIA = [
  {
    key: "values_empathy",
    label: "Values & Empathy",
    description:
      "Respect others, possess a compassionate mindset, inclusive and non-judgmental attitude",
    maxScore: 20,
  },
  {
    key: "social_awareness",
    label: "Social Awareness",
    description:
      "Aware of social issues, seeks to understand local realities, and is willing to contribute",
    maxScore: 15,
  },
  {
    key: "growth_mindset",
    label: "Growth Mindset",
    description:
      "Self-aware and reflects on the actions, learns from mistakes, is open to feedback",
    maxScore: 10,
  },
  {
    key: "leadership_initiative",
    label: "Leadership & Initiative",
    description:
      "Takes ownership of the problem, emphasizes personal and group initiatives to solve it through solution-oriented thinking",
    maxScore: 15,
  },
  {
    key: "critical_thinking",
    label: "Critical Thinking",
    description:
      "Applies logical reasoning, analyses multiple perspectives, and practical solutions",
    maxScore: 20,
  },
  {
    key: "communication",
    label: "Communication",
    description:
      "Expresses personal thoughts with transparency, brings up data-driven insights and factual information, engages in active listening, respects others' opinions",
    maxScore: 10,
  },
  {
    key: "collaboration",
    label: "Collaboration",
    description:
      "Encourages participation, acknowledges others' contribution and teamwork",
    maxScore: 10,
  },
];

export const RUBRIC_MAX_TOTAL = RUBRIC_CRITERIA.reduce(
  (sum, criterion) => sum + criterion.maxScore,
  0
); // 100

export function computeRubricTotal(rubricScores) {
  return RUBRIC_CRITERIA.reduce(
    (sum, criterion) => sum + (Number(rubricScores?.[criterion.key]) || 0),
    0
  );
}

// Per-evaluator score = average of three components normalized to
// RUBRIC_MAX_TOTAL (0-100): the rubric total, the feedback weight, and the
// recommendation weight.
export function computeEvaluatorScore({ rubricScores, feedbackWeight, recommendationWeight }) {
  const rubricTotal = computeRubricTotal(rubricScores);
  const feedbackComponent = (Number(feedbackWeight) / FEEDBACK_MAX_WEIGHT) * RUBRIC_MAX_TOTAL;
  const recommendationComponent =
    (Number(recommendationWeight) / RECOMMENDATION_MAX_WEIGHT) * RUBRIC_MAX_TOTAL;

  return (rubricTotal + feedbackComponent + recommendationComponent) / 3;
}

export function deriveSelectionStatus(averageScore) {
  if (averageScore >= 70) return SELECTION_STATUS.SELECTED;
  if (averageScore >= 40) return SELECTION_STATUS.WAITLISTED;
  return SELECTION_STATUS.REJECTED;
}
