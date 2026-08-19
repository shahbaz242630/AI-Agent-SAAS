import { Controller, Get } from "@nestjs/common";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UsersService, type AppUser } from "./users.service.js";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  async getMe(@CurrentAuthUser() authUser: AuthUser): Promise<AppUser> {
    return this.usersService.resolveOrProvision(authUser);
  }
}
