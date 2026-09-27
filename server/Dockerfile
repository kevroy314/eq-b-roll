# EQ B-Roll server: the community EQMacEmu image plus everything we had to fix to film with it.
# Built and started by Setup.bat; see docs/LOCAL_SERVER.md for the reasoning behind each piece.
#
# Pinned by digest so a rebuild months from now produces the same server.
FROM eqmacemu/eqmacemu@sha256:75d9a969386615d0a1043a1d07f85195713b81068970f4825b5fa578ecb91150

# Server source fixes, compiled in (only the zone server needs rebuilding, ~2 minutes).
COPY patches/ /broll/patches/
RUN cd /src && for p in /broll/patches/*.diff; do echo "applying $p" && patch -p1 < "$p"; done \
 && cd /src/build && ninja zone

# Database changes, applied at every start by the wrapper entrypoint.
COPY sql/ /broll/sql/
COPY broll-entrypoint.sh /usr/local/bin/broll-entrypoint.sh
ENTRYPOINT ["broll-entrypoint.sh"]
