// Finder keeps a tiny AppKit host for reopen events. Headless CLI replaces this
// process with private Node. Neither path runs a shell or writes to the bundle.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static NSString *userDataDirectory(void) {
    NSString *home = NSProcessInfo.processInfo.environment[@"HOME"];
    if (!home.isAbsolutePath) home = NSHomeDirectory();
    return [home stringByAppendingPathComponent:@"Library/Application Support/AIPLAY Studio"];
}

static int setupFailure(BOOL headless) {
    NSString *setupLog = [userDataDirectory() stringByAppendingPathComponent:@"setup.log"];
    fprintf(stderr, "AIPLAY Studio could not start its private runtime. Download the macOS package again.\n");
    fprintf(stderr, "Setup log, when available: %s\n", setupLog.fileSystemRepresentation);
    if (!headless) {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp activateIgnoringOtherApps:YES];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"AIPLAY Studio could not start";
        alert.informativeText = [NSString stringWithFormat:@"Its private runtime is missing or could not start. Download the macOS package again.\n\nSetup log, when available:\n%@", setupLog];
        [alert addButtonWithTitle:@"Close"];
        [alert runModal];
    }
    return 1;
}

@interface AIPLAYHost : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *node;
@property(nonatomic, copy) NSString *bootstrap;
@property(nonatomic, copy) NSArray<NSString *> *arguments;
@property(nonatomic, copy) NSDictionary<NSString *, NSString *> *environment;
@property(nonatomic, strong) NSTask *task;
@property(nonatomic, strong) NSFileHandle *reader;
@property(nonatomic, strong) NSURL *lastURL;
@property(nonatomic, strong) NSMutableData *pending;
@property(nonatomic) BOOL stopping;
@property(nonatomic) BOOL sawURL;
@property(nonatomic) BOOL wantsReopen;
@property(nonatomic) int eventFD;
@end

static dispatch_source_t terminateSignal;
static dispatch_source_t interruptSignal;
static void installTerminationSignals(void) {
    // Set up the host after the child is spawned, so ignored signal dispositions
    // cannot leak into the private runtime during its own initialization.
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN);
    terminateSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(terminateSignal, ^{ [NSApp terminate:nil]; }); dispatch_resume(terminateSignal);
    interruptSignal = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(interruptSignal, ^{ [NSApp terminate:nil]; }); dispatch_resume(interruptSignal);
}

@implementation AIPLAYHost
- (void)event:(NSString *)name extra:(NSDictionary *)extra {
    if (self.eventFD < 0) return;
    NSMutableDictionary *record = [@{ @"event":name, @"hostPid":@(getpid()), @"childPid":@(self.task.processIdentifier), @"childCount":@1 } mutableCopy];
    [record addEntriesFromDictionary:extra ?: @{}];
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
    if (!bytes || bytes.length > 8192) return;
    struct stat state;
    if (fstat(self.eventFD, &state) != 0 || state.st_size + (off_t)bytes.length + 1 > 1024 * 1024) return;
    NSMutableData *line = [bytes mutableCopy]; [line appendBytes:"\n" length:1];
    const char *cursor = line.bytes; NSUInteger left = line.length;
    while (left) { ssize_t n = write(self.eventFD, cursor, left); if (n <= 0) break; cursor += n; left -= (NSUInteger)n; }
}
- (void)receive:(NSData *)bytes {
    // Only known progress URL lines reach the event log. Raw app output remains
    // on stdout; credentials, prompts and arbitrary diagnostics are not copied.
    [self.pending appendData:bytes];
    if (self.pending.length > 65536) { [self.pending setLength:0]; return; }
    for (;;) {
        const unsigned char *raw = self.pending.bytes; NSUInteger end = NSNotFound;
        for (NSUInteger i = 0; i < self.pending.length; i++) if (raw[i] == '\n') { end = i; break; }
        if (end == NSNotFound) break;
        NSData *line = [self.pending subdataWithRange:NSMakeRange(0, end)];
        [self.pending replaceBytesInRange:NSMakeRange(0, end + 1) withBytes:NULL length:0];
        NSString *text = [[NSString alloc] initWithData:line encoding:NSUTF8StringEncoding];
        if (!text) continue;
        NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[ \\t]*(Setup|launcher|Studio launcher): (http://127\\.0\\.0\\.1:([0-9]{1,5})/([a-f0-9]{48}/)?)[\\r]?$" options:0 error:nil];
        NSTextCheckingResult *match = [pattern firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
        if (!match) continue;
        NSInteger port = [[text substringWithRange:[match rangeAtIndex:3]] integerValue];
        if (port < 1 || port > 65535) continue;
        NSString *kind = [text substringWithRange:[match rangeAtIndex:1]];
        BOOL setup = [kind isEqualToString:@"Setup"];
        if (setup != ([match rangeAtIndex:4].location != NSNotFound)) continue;
        NSURL *url = [NSURL URLWithString:[text substringWithRange:[match rangeAtIndex:2]]];
        self.lastURL = url; self.sawURL = YES;
        [self event:@"url-ready" extra:@{ @"kind":setup ? @"setup" : @"launcher", @"url":url.absoluteString }];
        if (self.wantsReopen) { self.wantsReopen = NO; [NSWorkspace.sharedWorkspace openURL:url]; }
    }
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.eventFD = -1; self.pending = [NSMutableData data];
    NSString *folder = userDataDirectory();
    NSString *current = [folder stringByDeletingLastPathComponent];
    NSArray *parents = @[[current stringByDeletingLastPathComponent], current, folder];
    BOOL safeParent = YES;
    for (NSString *parent in parents) {
        [NSFileManager.defaultManager createDirectoryAtPath:parent withIntermediateDirectories:NO attributes:@{ NSFilePosixPermissions:@0700 } error:nil];
        struct stat item;
        if (lstat(parent.fileSystemRepresentation, &item) != 0 || !S_ISDIR(item.st_mode) || S_ISLNK(item.st_mode)) { safeParent = NO; break; }
    }
    int fd = safeParent ? open([[folder stringByAppendingPathComponent:@"native-entry.jsonl"] fileSystemRepresentation], O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0600) : -1;
    struct stat st;
    if (fd >= 0 && fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == getuid() && st.st_nlink == 1 && fchmod(fd, 0600) == 0) self.eventFD = fd;
    else if (fd >= 0) close(fd);
    self.task = [[NSTask alloc] init];
    self.task.executableURL = [NSURL fileURLWithPath:self.node];
    self.task.arguments = [@[self.bootstrap] arrayByAddingObjectsFromArray:self.arguments];
    self.task.environment = self.environment;
    NSPipe *pipe = NSPipe.pipe; self.reader = pipe.fileHandleForReading;
    self.task.standardOutput = pipe; self.task.standardError = pipe;
    __weak AIPLAYHost *weakSelf = self;
    self.reader.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *bytes = handle.availableData;
        if (!bytes.length) { handle.readabilityHandler = nil; return; }
        if (isatty(STDOUT_FILENO)) write(STDOUT_FILENO, bytes.bytes, bytes.length);
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf receive:bytes]; });
    };
    self.task.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            AIPLAYHost *host = weakSelf; if (!host) return;
            host.reader.readabilityHandler = nil;
            [host event:@"child-exit" extra:@{ @"status":@(task.terminationStatus) }];
            if (!host.sawURL && task.terminationStatus != 0 && !host.stopping) setupFailure(NO);
            if (host.stopping) [NSApp replyToApplicationShouldTerminate:YES];
            else [NSApp terminate:nil];
        });
    };
    NSError *error = nil;
    if (![self.task launchAndReturnError:&error]) { setupFailure(NO); [NSApp terminate:nil]; return; }
    [self event:@"child-started" extra:nil];
    installTerminationSignals();
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)application hasVisibleWindows:(BOOL)flag {
    [self event:@"reopen-request" extra:nil];
    BOOL opened = self.lastURL && [NSWorkspace.sharedWorkspace openURL:self.lastURL];
    if (!self.lastURL && self.task.running) self.wantsReopen = YES;
    [self event:@"reopen" extra:@{ @"opened":@(opened) }];
    return NO;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)application {
    if (self.task.running) {
        self.stopping = YES;
        @try { [self.task terminate]; } @catch (NSException *exception) { if (!self.task.running) return NSTerminateNow; }
        NSTask *owned = self.task; pid_t ownedPID = owned.processIdentifier;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (self.stopping && self.task == owned && owned.running && owned.processIdentifier == ownedPID) kill(ownedPID, SIGKILL);
        });
        return NSTerminateLater;
    }
    return NSTerminateNow;
}
- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.eventFD >= 0) { close(self.eventFD); self.eventFD = -1; }
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSMutableArray<NSString *> *forward = [NSMutableArray array]; BOOL headless = NO;
        for (int i = 1; i < argc; i++) {
            NSString *arg = [NSString stringWithUTF8String:argv[i]];
            if (!arg) return setupFailure(YES);
            if ([arg hasPrefix:@"-psn_"]) continue;
            if ([arg isEqualToString:@"--help"] || [arg isEqualToString:@"-h"] || [arg isEqualToString:@"--install-only"] || [arg isEqualToString:@"--no-open"]) headless = YES;
            [forward addObject:arg];
        }
        NSURL *resources = NSBundle.mainBundle.resourceURL;
        if (!resources.isFileURL) return setupFailure(headless);
        NSString *node = [[resources URLByAppendingPathComponent:@"runtime/bin/node"] path];
        NSString *bootstrap = [[resources URLByAppendingPathComponent:@"bootstrap.mjs"] path];
        if (![NSFileManager.defaultManager isExecutableFileAtPath:node] || ![NSFileManager.defaultManager isReadableFileAtPath:bootstrap]) return setupFailure(headless);
        NSString *oldPath = NSProcessInfo.processInfo.environment[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
        NSString *localPath = [NSString stringWithFormat:@"%@:%@", node.stringByDeletingLastPathComponent, oldPath];
        if (setenv("PATH", localPath.UTF8String, 1) != 0) return setupFailure(headless);
        if (headless) {
            char **childArgv = calloc(forward.count + 3, sizeof(char *));
            if (!childArgv) return setupFailure(YES);
            childArgv[0] = strdup(node.fileSystemRepresentation); childArgv[1] = strdup(bootstrap.fileSystemRepresentation);
            for (NSUInteger i = 0; i < forward.count; i++) childArgv[i + 2] = strdup(forward[i].UTF8String);
            for (NSUInteger i = 0; i < forward.count + 2; i++) if (!childArgv[i]) return setupFailure(YES);
            execv(node.fileSystemRepresentation, childArgv);
            for (NSUInteger i = 0; i < forward.count + 2; i++) free(childArgv[i]); free(childArgv);
            return setupFailure(YES);
        }
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        // NSApplication.delegate is weak; retain the host across the run loop.
        __attribute__((objc_precise_lifetime)) AIPLAYHost *host = [[AIPLAYHost alloc] init];
        host.eventFD = -1; host.node = node; host.bootstrap = bootstrap; host.arguments = forward;
        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy]; environment[@"PATH"] = localPath; host.environment = environment;
        NSApp.delegate = host;
        [NSApp run];
        return 0;
    }
}
