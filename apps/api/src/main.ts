import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { API_CONFIG, ApiConfig } from './config/api.config';
import { configureApp } from './configure-app';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));

  const config = app.get<ApiConfig>(API_CONFIG);
  await app.listen(config.port);
  Logger.log(`API ${config.instanceId} listening on port ${config.port}`, 'Bootstrap');
}

void bootstrap();
