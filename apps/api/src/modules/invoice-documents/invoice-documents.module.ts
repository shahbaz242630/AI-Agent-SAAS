import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module.js";
import { EXTRACTION_PROVIDER } from "../integrations/extraction/extraction-provider.js";
import { RuleBasedExtractionProvider } from "../integrations/extraction/rule-based-extraction.provider.js";
import { InvoiceDocumentsController } from "./invoice-documents.controller.js";
import { InvoiceDocumentsService } from "./invoice-documents.service.js";

@Module({
  imports: [UsersModule],
  controllers: [InvoiceDocumentsController],
  providers: [
    InvoiceDocumentsService,
    // The extraction-provider adapter (BRD §11; plan §7.4): rule-based today,
    // swappable for an AI provider behind the same interface later.
    { provide: EXTRACTION_PROVIDER, useClass: RuleBasedExtractionProvider },
  ],
})
export class InvoiceDocumentsModule {}
