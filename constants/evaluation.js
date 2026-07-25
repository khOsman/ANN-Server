export const FEEDBACK_OPTIONS = {
  needs_improvement: { label: "Needs Improvement", weight: 1 },
  average: { label: "Average", weight: 2 },
  good: { label: "Good", weight: 3 },
  excellent: { label: "Excellent", weight: 4 },
};

export const FEEDBACK_OPTION_KEYS = Object.keys(FEEDBACK_OPTIONS);
export const FEEDBACK_MAX_WEIGHT = 4;

export const RECOMMENDATION_OPTIONS = {
  neutral: { label: "Neutral", weight: 1 },
  potential: { label: "Potential", weight: 2 },
  high_potential: { label: "High Potential", weight: 3 },
};

export const RECOMMENDATION_OPTION_KEYS = Object.keys(RECOMMENDATION_OPTIONS);
export const RECOMMENDATION_MAX_WEIGHT = 3;

export const REQUIRED_EVALUATIONS = 3;

export const SELECTION_STATUS = {
  PENDING: "Pending",
  SELECTED: "Selected",
  WAITLISTED: "Waitlisted",
  REJECTED: "Rejected",
};

// Per-evaluator score = average of three components normalized to 0-10:
// the manual FGD score, the feedback weight, and the recommendation weight.
export function computeEvaluatorScore({ fgdScore, feedbackWeight, recommendationWeight }) {
  const scoreComponent = Number(fgdScore) || 0;
  const feedbackComponent = (Number(feedbackWeight) / FEEDBACK_MAX_WEIGHT) * 10;
  const recommendationComponent =
    (Number(recommendationWeight) / RECOMMENDATION_MAX_WEIGHT) * 10;

  return (scoreComponent + feedbackComponent + recommendationComponent) / 3;
}

export function deriveSelectionStatus(averageScore) {
  if (averageScore >= 7) return SELECTION_STATUS.SELECTED;
  if (averageScore >= 4) return SELECTION_STATUS.WAITLISTED;
  return SELECTION_STATUS.REJECTED;
}
