import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TenantContextService } from '../../database/tenant-context.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CurrentUserContextHolder } from './decorators/current-user.decorator';
import { ActiveOrganizationGuard } from './guards/active-organization.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PasswordService } from './password.service';
import { RefreshCookieService } from './refresh-cookie.service';
import { SessionsRepository } from './sessions.repository';
import { TokenService } from './token.service';
import { UsersRepository } from './users.repository';

/**
 * The three guards are registered globally and their order is load-bearing:
 * authentication resolves the user, then the organization guard resolves the
 * tenant using that user, then the roles guard checks the role that resolved.
 * Nest runs APP_GUARD providers in registration order, so this list *is* the
 * security pipeline.
 */
@Module({
  imports: [JwtModule.register({}), OrganizationsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    RefreshCookieService,
    TokenService,
    UsersRepository,
    SessionsRepository,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ActiveOrganizationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, PasswordService, TokenService, UsersRepository, SessionsRepository],
})
export class AuthModule {
  constructor(context: TenantContextService) {
    // Parameter decorators run outside the injector; hand them the singleton.
    CurrentUserContextHolder.service = context;
  }
}
