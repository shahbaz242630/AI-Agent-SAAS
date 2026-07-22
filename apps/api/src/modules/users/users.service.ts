import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { withAuthIdentity, withUser } from "@eva/database";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";
import type { AuthUser } from "../authentication/current-auth-user.decorator.js";

export interface AppUser {
  id: string;
  email: string;
  fullName: string | null;
  authUserId: string | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the app users row for a verified JWT identity, auto-provisioning
   * it on first login (Slice 0.3). Emails are lowercased before write (gap
   * G-004) — lookups match on auth_user_id, so casing can never split an
   * identity into two rows.
   */
  async resolveOrProvision(authUser: AuthUser): Promise<AppUser> {
    const existing = await this.findByAuthUserId(authUser.authUserId);
    if (existing) return existing;

    const id = randomUUID();
    try {
      return await withUser(this.prisma.db, id, (tx) =>
        tx.user.create({
          data: { id, email: authUser.email.toLowerCase(), authUserId: authUser.authUserId },
        }),
      );
    } catch (error) {
      // Concurrent first login: the other request won the insert — re-read.
      const raced = await this.findByAuthUserId(authUser.authUserId);
      if (raced) return raced;
      throw error;
    }
  }

  private findByAuthUserId(authUserId: string): Promise<AppUser | null> {
    return withAuthIdentity(this.prisma.db, authUserId, (tx) =>
      tx.user.findFirst({ where: { authUserId } }),
    );
  }
}
