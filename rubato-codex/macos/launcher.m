#import <Cocoa/Cocoa.h>
#include <unistd.h>

int main(int argc, char **argv) {
  @autoreleasepool {
    NSBundle *bundle = [NSBundle mainBundle];
    NSDictionary *paths = [NSDictionary dictionaryWithContentsOfFile:
      [[bundle resourcePath] stringByAppendingPathComponent:@"rubato-paths.plist"]];
    if (!paths) { fprintf(stderr, "Rubato: missing managed paths\n"); return 1; }
    NSString *home = paths[@"codexHome"];
    NSString *profile = paths[@"electronHome"];
    setenv("CODEX_HOME", [home fileSystemRepresentation], 1);
    setenv("CODEX_SQLITE_HOME", [[home stringByAppendingPathComponent:@"sqlite"] fileSystemRepresentation], 1);
    setenv("OPENCODEX_HOME", [[home stringByAppendingPathComponent:@"opencodex"] fileSystemRepresentation], 1);
    setenv("CODEX_ELECTRON_USER_DATA_PATH", [profile fileSystemRepresentation], 1);
    setenv("RUBATO_APP", [[bundle bundlePath] fileSystemRepresentation], 1);
    if (argc == 2 && strcmp(argv[1], "--rubato-print-paths") == 0) {
      NSData *data = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
      fwrite([data bytes], 1, [data length], stdout); return 0;
    }
    for (NSRunningApplication *app in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if ([[app bundleIdentifier] isEqualToString:@"com.openai.codex"]) {
        NSAlert *alert = [[NSAlert alloc] init];
        [alert setMessageText:@"먼저 ChatGPT/Codex를 종료해 주세요"];
        [alert setInformativeText:@"Rubato와 순정 앱의 동시 실행은 지원하지 않습니다. 실행 중인 작업은 종료하지 않았습니다."];
        [alert runModal]; return 2;
      }
    }
    NSString *upstream = paths[@"upstreamApp"];
    if (!upstream) { fprintf(stderr, "Rubato: missing upstream app\n"); return 1; }
    NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
    config.createsNewApplicationInstance = YES;
    config.allowsRunningApplicationSubstitution = NO;
    config.arguments = @[[NSString stringWithFormat:@"--user-data-dir=%@", profile]];
    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    env[@"CODEX_HOME"] = home;
    env[@"CODEX_SQLITE_HOME"] = [home stringByAppendingPathComponent:@"sqlite"];
    env[@"CODEX_ELECTRON_USER_DATA_PATH"] = profile;
    env[@"OPENCODEX_HOME"] = [home stringByAppendingPathComponent:@"opencodex"];
    [env removeObjectForKey:@"CODEX_SPARKLE_ENABLED"];
    config.environment = env;
    [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:upstream]
      configuration:config completionHandler:^(NSRunningApplication *app, NSError *error) {
        if (error || !app) { fprintf(stderr, "Rubato launch failed: %s\n", [[error description] UTF8String]); exit(1); }
        printf("Rubato profile launched: pid=%d\n", app.processIdentifier); exit(0);
      }];
    [[NSRunLoop mainRunLoop] run];
    return 0;
  }
}
