import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { OrganisationsController } from "./organisations.controller.js";
import { OrganisationsService } from "./organisations.service.js";

@Module({
  imports: [UsersModule],
  controllers: [OrganisationsController],
  providers: [OrganisationsService],
})
export class OrganisationsModule {}
