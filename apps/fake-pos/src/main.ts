import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));

  const port = Number(process.env.FAKE_POS_PORT ?? 4000);
  await app.listen(port);
  Logger.log(`Fake POS listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
