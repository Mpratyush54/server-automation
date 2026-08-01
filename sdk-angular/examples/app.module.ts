import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';
import { AppComponent } from './app.component';

/**
 * Classic NgModule bootstrap.
 * Replace apiBase / token / projectId with env or build-time injection.
 */
@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    HttpClientModule,
    PlatformModule.forRoot({
      apiBase: 'https://api.148.113.59.3.sslip.io',
      token: 'sdk_live_REPLACE_ME',
      projectId: 'REPLACE_WITH_PROJECT_ID',
      environment: 'development',
      appName: 'angular-sdk-example',
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
