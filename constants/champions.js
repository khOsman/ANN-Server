export const CHAMPION_ROLES = {
  SELECTION_COMMITTEE: "selection_committee",
  FACILITATOR: "facilitator",
  CO_FACILITATOR: "co_facilitator",
  MENTOR: "mentor",
  YCN: "ycn",
};

export const CHAMPION_ROLE_OPTIONS = Object.values(CHAMPION_ROLES);

// Champions moved from a single `role` string to a `roles` array so one
// person can hold multiple roles (e.g. Selection Committee + Mentor). This
// reads either shape so pre-migration docs (still carrying only the old
// `role` field) keep working without a migration script.
export function getChampionRoles(champion) {
  if (Array.isArray(champion?.roles) && champion.roles.length > 0) {
    return champion.roles;
  }
  if (champion?.role) return [champion.role];
  return [];
}

export const REGISTRATION_STATUS = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export const REGISTRATION_STATUS_OPTIONS = Object.values(REGISTRATION_STATUS);

export const ACCOUNT_STATUS = {
  NOT_CREATED: "Not Created",
  INVITATION_SENT: "Invitation Sent",
  PASSWORD_SET: "Password Set",
  ACTIVE: "Active",
};

export const ACCOUNT_STATUS_OPTIONS = Object.values(ACCOUNT_STATUS);

export const MEMBER_STATUS = {
  INACTIVE: "Inactive",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

export const MEMBER_STATUS_OPTIONS = Object.values(MEMBER_STATUS);

export const GENDER_OPTIONS = ["Male", "Female", "Other", "Prefer not to say"];

export const EDUCATION_LEVEL_OPTIONS = [
  "Secondary (SSC)",
  "Higher Secondary (HSC)",
  "Bachelor's",
  "Master's",
  "PhD",
  "Other",
];
