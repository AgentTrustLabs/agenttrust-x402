/*
 * SO_PEERCRED gate (test-only harness helper).
 *
 * Reads the peer credentials of a connected Unix socket fd and writes them as JSON to
 * stdout. This is a REAL kernel peer credential read, not a caller claim.
 *
 * Build:  cc -O2 -o authz-peercred authz-peercred.c
 * Run:    ./authz-peercred <fd>
 * Output:  {"uid":1001,"gid":1001,"pid":1234}
 *
 * Exit 2 on error.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/types.h>

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <fd>\n", argv[0]);
        return 2;
    }
    int fd = -1;
    if (sscanf(argv[1], "%d", &fd) != 1 || fd < 0) {
        fprintf(stderr, "invalid fd: %s\n", argv[1]);
        return 2;
    }
    struct ucred cred;
    memset(&cred, 0, sizeof(cred));
    socklen_t len = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
        fprintf(stderr, "getsockopt(SO_PEERCRED) failed: %s\n", strerror(errno));
        return 2;
    }
    printf("{\"uid\":%u,\"gid\":%u,\"pid\":%d}\n", (unsigned)cred.uid, (unsigned)cred.gid, (int)cred.pid);
    return 0;
}
