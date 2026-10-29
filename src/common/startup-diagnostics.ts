import { EnvironmentConfigurationError } from './config/environment.js';

export interface StartupDiagnostic {
  severity: 'ERROR';
  event: 'startup-failed';
  phase: string;
  message: string;
  fields?: readonly string[];
  code?: string;
}

const failureMessages: Record<string, string> = {
  '28P01': 'DB 인증에 실패했습니다. DB_USER와 DB_PASSWORD를 확인하세요.',
  '28000': 'DB 인증이 허용되지 않았습니다. DB 사용자와 연결 설정을 확인하세요.',
  '3D000': 'DB_NAME에 해당하는 데이터베이스가 없습니다. Cloud SQL 데이터베이스 목록을 확인하세요.',
  '42501': 'DB 작업 권한이 부족합니다. DB 사용자와 스키마 권한을 확인하세요.',
  '42P01': '필요한 DB 테이블이 없습니다. 시작 마이그레이션 로그와 DB_NAME을 확인하세요.',
  '42703':
    'DB 스키마가 현재 코드와 다릅니다. 시작 마이그레이션 로그와 등록된 마이그레이션을 확인하세요.',
  '57P03': 'DB가 아직 연결을 받을 수 없습니다. Cloud SQL 인스턴스 상태를 확인하세요.',
  ECONNREFUSED: 'DB 연결이 거부되었습니다. DB_HOST, DB_PORT와 Cloud SQL 연결을 확인하세요.',
  ETIMEDOUT: 'DB 연결 시간이 초과되었습니다. Cloud SQL 연결과 네트워크 경로를 확인하세요.',
  ENOTFOUND: 'DB 호스트를 찾지 못했습니다. DB_HOST를 확인하세요.',
  ENOENT: '필요한 소켓 또는 파일이 없습니다. Cloud SQL 연결과 이미지의 데이터 파일을 확인하세요.',
  EADDRINUSE: '수신 포트가 이미 사용 중입니다. 컨테이너 실행 명령과 PORT를 확인하세요.',
  EACCES: '소켓, 파일 또는 포트 접근이 거부되었습니다. 실행 권한을 확인하세요.',
};

/** Only allowlisted diagnostics are logged; driver messages, queries and stacks may contain secrets. */
export function startupFailure(error: unknown, phase: string): StartupDiagnostic {
  const base = {
    severity: 'ERROR',
    event: 'startup-failed',
    phase,
  } as const;

  if (error instanceof EnvironmentConfigurationError) {
    return {
      ...base,
      message: error.message,
      fields: error.fields,
    };
  }

  const driverError =
    error && typeof error === 'object' && 'driverError' in error ? error.driverError : error;
  const code =
    driverError && typeof driverError === 'object' && 'code' in driverError
      ? driverError.code
      : undefined;

  if (typeof code === 'string' && Object.hasOwn(failureMessages, code)) {
    return {
      ...base,
      code,
      message: failureMessages[code],
    };
  }

  return {
    ...base,
    message: '서버 시작에 실패했습니다. 시작 단계, 환경변수와 DB 마이그레이션을 확인하세요.',
  };
}
