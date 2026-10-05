import { Global, Module } from '@nestjs/common';
import { EnvSecretResolver } from './env-secret-resolver';
import { SECRET_RESOLVER } from './secret-resolver';

/**
 * Binds the `SecretResolver` port. Nothing consumes it yet: the first caller
 * is GitHub Real, which is also where the external secret-manager provider
 * replaces this binding (ADR 0014).
 */
@Global()
@Module({
  providers: [{ provide: SECRET_RESOLVER, useFactory: () => new EnvSecretResolver() }],
  exports: [SECRET_RESOLVER],
})
export class SecretsModule {}
