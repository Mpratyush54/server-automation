import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum SmtpProvider {
  CUSTOM = 'custom',
  SES = 'ses',
  SENDGRID = 'sendgrid',
  MAILGUN = 'mailgun',
}

@Entity('smtp_configs')
export class SmtpConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'enum', enum: SmtpProvider, default: SmtpProvider.CUSTOM })
  provider: SmtpProvider;

  @Column({ type: 'varchar', length: 255, nullable: true })
  host: string | null;

  @Column({ type: 'int', nullable: true })
  port: number | null;

  @Column({ type: 'boolean', default: true })
  secure: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  username: string | null;

  @Column({ type: 'text', nullable: true })
  password: string | null;

  @Column({ type: 'text', nullable: true, name: 'api_key' })
  apiKey: string | null;

  @Column({ type: 'varchar', length: 255, name: 'from_email' })
  fromEmail: string;

  @Column({ type: 'varchar', length: 255, name: 'from_name', nullable: true })
  fromName: string | null;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
