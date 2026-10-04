import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SetPermissionOverridesInput, setPermissionOverridesSchema } from '@qa-flow-hub/shared';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ProjectScoped } from '../auth/decorators/project-scoped.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ProjectPermissionsService } from './project-permissions.service';

/**
 * Effective permissions and per-member overrides inside one project.
 *
 * `GET …/permissions/me` carries no requirement at all: every member may learn
 * what they can do, and the web client uses it to decide which controls to
 * render — a convenience, never the check itself. Reading another member's
 * permissions needs `members.read`; writing overrides needs `members.manage`,
 * which by default is held by owners, administrators and project managers —
 * the same set that manages project roles today.
 */
@ApiTags('projects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@ProjectScoped()
@Controller('projects/:projectId/permissions')
export class ProjectPermissionsController {
  constructor(private readonly permissions: ProjectPermissionsService) {}

  @Get('me')
  @ApiOperation({ summary: 'Effective permissions of the caller in this project, with their source' })
  mine(@Param('projectId') projectId: string) {
    return this.permissions.mine(projectId);
  }

  @RequirePermission('members.read')
  @Get('overrides')
  @ApiOperation({ summary: 'Every permission override defined in this project' })
  overrides(@Param('projectId') projectId: string) {
    return this.permissions.listForProject(projectId);
  }

  @RequirePermission('members.read')
  @Get('members/:userId')
  @ApiOperation({ summary: 'Effective permissions of one member in this project' })
  forMember(@Param('projectId') projectId: string, @Param('userId') userId: string) {
    return this.permissions.forMember(projectId, userId);
  }

  @RequirePermission('members.manage')
  @Put('members/:userId')
  @ApiOperation({ summary: 'Replace the permission overrides of one member in this project' })
  replace(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body(zodBody(setPermissionOverridesSchema)) body: SetPermissionOverridesInput,
  ) {
    return this.permissions.replace(projectId, userId, body);
  }
}

/** The static catalogue: permissions grouped by module, and each role's defaults. */
@ApiTags('projects')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('permissions')
export class PermissionCatalogController {
  constructor(private readonly permissions: ProjectPermissionsService) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Permission catalogue and role → default permissions mapping' })
  catalog() {
    return this.permissions.catalog();
  }
}
