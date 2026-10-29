import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApplication } from './common/http/configure-app.js';
import { validateEnvironment } from './common/config/environment.js';
import { startupFailure } from './common/startup-diagnostics.js';

let app: INestApplication | undefined;
let phase = 'configuration';

async function bootstrap() {
  validateEnvironment(process.env);

  phase = 'dependency-initialization';

  app = await NestFactory.create(AppModule, {
    abortOnError: false,
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });

  phase = 'http-configuration';

  const config = configureApplication(app);

  app.enableShutdownHooks();

  phase = 'application-initialization';

  await app.init();

  phase = 'listen';

  await app.listen(config.PORT, config.HOST);
}

bootstrap().catch(async (error: unknown) => {
  console.error(JSON.stringify(startupFailure(error, phase)));

  if (app) {
    try {
      await app.close();
    } catch {
      console.error('시작 실패 후 애플리케이션 종료 중 오류가 발생했습니다.');
    }
  }

  process.exitCode = 1;
});
