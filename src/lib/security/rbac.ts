export type Role = 'admin' | 'operator' | 'viewer';

export type Permission =
  | 'research:read'
  | 'research:run'
  | 'discovery:read'
  | 'project:read'
  | 'project:create'
  | 'project:write'
  | 'project:delete'
  | 'ide:read'
  | 'ide:write'
  | 'build:read'
  | 'build:run'
  | 'preview:read'
  | 'preview:control'
  | 'factory:run'
  | 'schedule:read'
  | 'schedule:write'
  | 'chat:use'
  | 'system:read'
  | 'system:admin'
  | 'user:manage';

const VIEWER: readonly Permission[] = [
  'research:read',
  'discovery:read',
  'project:read',
  'ide:read',
  'build:read',
  'preview:read',
  'schedule:read',
  'system:read',
];

const OPERATOR: readonly Permission[] = [
  ...VIEWER,
  'research:run',
  'project:create',
  'project:write',
  'ide:write',
  'build:run',
  'preview:control',
  'factory:run',
  'chat:use',
  'schedule:write',
];

const ADMIN: readonly Permission[] = [...OPERATOR, 'project:delete', 'system:admin', 'user:manage'];

const MATRIX: Record<Role, readonly Permission[]> = {
  viewer: VIEWER,
  operator: OPERATOR,
  admin: ADMIN,
};

export function permissionsFor(role: Role): readonly Permission[] {
  return MATRIX[role];
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(permission: Permission, role: Role) {
    super(`Role "${role}" is not permitted to perform "${permission}"`);
    this.name = 'AuthorizationError';
  }
}

export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new AuthorizationError(permission, role);
}
