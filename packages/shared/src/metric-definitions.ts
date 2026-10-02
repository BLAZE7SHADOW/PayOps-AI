/** What each Overview performance number means (P5 task 1, D079). Shown in the UI next to the figure. */
export const METRIC_DEFINITIONS = {
  resolutionTime:
    'Median time from a case opening to it being resolved, for cases resolved in the last 7 days. Includes time spent waiting for approval.',
  autoResolutionRate:
    'Share of cases resolved in the last 7 days whose resolution was recorded by the agent. Cases an operator resolved, or that closed on their own, are not counted.',
  agentAccuracy:
    'Share of operator ratings in the last 7 days that marked the agent\'s diagnosis Right. Only diagnoses an operator rated are counted.',
  approvalTurnaround:
    'Median time from an approval being requested to someone deciding it, for approvals decided in the last 7 days.',
  costPerCase:
    'Model spend recorded on agent runs created in the last 7 days, divided by the number of distinct cases those runs worked on.',
} as const;
