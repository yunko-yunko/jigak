import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApplication } from './common/http/configure-app.js';
import { validateEnvironment } from './common/config/environment.js';

async function bootstrap() {
  validateEnvironment(process.env);

  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });

  const config = configureApplication(app);

  app.enableShutdownHooks();
  await app.listen(config.PORT, config.HOST);
}

bootstrap().catch(() => {
  console.error('서버 시작에 실패했습니다. 환경변수와 DB 마이그레이션을 확인하세요.');

  process.exitCode = 1;
});
