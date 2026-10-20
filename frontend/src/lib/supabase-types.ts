export const roleKeys = ["admin", "teacher", "student"] as const;
export type AppRole = (typeof roleKeys)[number];

export function isAppRole(value: string): value is AppRole {
  return roleKeys.includes(value as AppRole);
}

export type UserProfile = {
  id: string;
  role: AppRole;
  full_name: string;
  initials: string | null;
  department_id: string | null;
  class_id: string | null;
  batch_id: string | null;
};
