import { SetMetadata, type CustomDecorator } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Exempts an endpoint from the global JWT guard (e.g. GET /health). */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
