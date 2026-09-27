import { Module } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { LocalStorageProvider } from './local-storage.provider';
import { MemoryStorageProvider } from './memory-storage.provider';
import { STORAGE_PROVIDER, StorageProvider } from './storage-provider';

/**
 * Binds the `StorageProvider` token to one implementation, chosen by
 * `STORAGE_PROVIDER`. Business modules import this module and inject the
 * token; none of them names a class. Adding S3 is one more `case` here plus
 * the class — nothing in `modules/` changes.
 */
@Module({
  providers: [
    LocalStorageProvider,
    MemoryStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      inject: [AppConfigService, LocalStorageProvider, MemoryStorageProvider],
      useFactory: (
        config: AppConfigService,
        local: LocalStorageProvider,
        memory: MemoryStorageProvider,
      ): StorageProvider => {
        switch (config.storage.provider) {
          case 'local':
            return local;
          case 'memory':
            return memory;
        }
      },
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
