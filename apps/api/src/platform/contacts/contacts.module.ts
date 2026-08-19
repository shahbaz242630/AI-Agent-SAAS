import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";

@Module({
  imports: [UsersModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
