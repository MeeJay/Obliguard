import { db } from '../db';
import { hashPassword } from '../utils/crypto';
import type { User, UserRole } from '@obliview/shared';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferredLanguage: 'en',
    enrollmentVersion: 0,
  };
}

export const userService = {
  async getAll(): Promise<User[]> {
    const rows = await db<UserRow>('users').orderBy('username');
    return rows.map(rowToUser);
  },

  async getById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  async create(data: {
    username: string;
    password: string;
    displayName?: string | null;
    role?: UserRole;
  }): Promise<User> {
    const passwordHash = await hashPassword(data.password);

    const [row] = await db<UserRow>('users')
      .insert({
        username: data.username,
        password_hash: passwordHash,
        display_name: data.displayName || null,
        role: data.role || 'user',
      })
      .returning('*');

    return rowToUser(row);
  },

  async update(id: number, data: {
    username?: string;
    displayName?: string | null;
    role?: UserRole;
    isActive?: boolean;
  }): Promise<User | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.username !== undefined) updateData.username = data.username;
    if (data.displayName !== undefined) updateData.display_name = data.displayName;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) updateData.is_active = data.isActive;

    const [row] = await db<UserRow>('users')
      .where({ id })
      .update(updateData)
      .returning('*');

    return row ? rowToUser(row) : null;
  },

  async changePassword(id: number, newPassword: string): Promise<boolean> {
    const passwordHash = await hashPassword(newPassword);
    const count = await db('users')
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: new Date() });
    return count > 0;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('users').where({ id }).del();
    return count > 0;
  },
};
