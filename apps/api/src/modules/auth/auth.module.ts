import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TenantContextService } from '../../database/tenant-context.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProjectsModule } from '../projects/projects.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CurrentUserContextHolder } from './decorators/current-user.decorator';
import { ActiveOrganizationGuard } from './guards/active-organization.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { ProjectScopeContractInterceptor } from './interceptors/project-scope-contract.interceptor';
import { MfaController } from './mfa/mfa.controller';
import { MfaService } from './mfa/mfa.service';
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
  // `ProjectsModule` is here for `ProjectAccessService`, which the roles guard
  // consults on project-scoped routes. The dependency stays one-directional:
  // projects know nothing about auth.
  imports: [JwtModule.register({}), OrganizationsModule, ProjectsModule],
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    MfaService,
    PasswordService,
    RefreshCookieService,
    TokenService,
    UsersRepository,
    SessionsRepository,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ActiveOrganizationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: ProjectScopeContractInterceptor },
  ],
  exports: [AuthService, PasswordService, TokenService, UsersRepository, SessionsRepository],
})
export class AuthModule {
  constructor(context: TenantContextService) {
    // Parameter decorators run outside the injector; hand them the singleton.
    CurrentUserContextHolder.service = context;
  }
}
