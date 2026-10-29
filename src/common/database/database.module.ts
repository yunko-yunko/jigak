import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DatabaseService } from './database.service.js';
import { createDataSourceOptions } from './data-source.js';
import { initializeDatabase } from './initialize-database.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...createDataSourceOptions(), retryAttempts: 1 }),
      dataSourceFactory: (options) =>
        initializeDatabase(new DataSource(options ?? createDataSourceOptions())),
    }),
  ],
  providers: [DatabaseService],
  exports: [DatabaseService, TypeOrmModule],
})
export class DatabaseModule {}
