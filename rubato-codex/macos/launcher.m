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
    setenv("CODEX_SPARKLE_ENABLED", "false", 1);
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
    NSString *real = [[[bundle executablePath] stringByDeletingLastPathComponent]
      stringByAppendingPathComponent:paths[@"realExecutable"]];
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    args[0] = (char *)[real fileSystemRepresentation];
    args[1] = (char *)[[NSString stringWithFormat:@"--user-data-dir=%@", profile] UTF8String];
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    execv(args[0], args);
    perror("Rubato launcher"); return 1;
  }
}
