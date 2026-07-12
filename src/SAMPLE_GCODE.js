/**
 * Sample programs, one per machine mode.
 *
 * SAMPLE_GCODE (milling) exercises absolute mode, rapids, linear feeds, CW/CCW
 * arcs (I/J), a full circle, and a G81 drilling canned cycle.
 *
 * SAMPLE_TURNING exercises the lathe conventions: the ZX plane, X as a
 * diameter, G18 arcs via I/K, G99 feed-per-revolution against an S word, and a
 * G71 roughing cycle finished by G70 over the same N100..N200 profile.
 */
export const SAMPLE_GCODE = `%
( Phase 0 demo: contour + pocket ramp + drilled holes )
G21 G90 G17      ; mm, absolute, XY plane
G0 Z5            ; safe height
G0 X0 Y0
G1 Z-2 F150      ; plunge
G1 X50 F400      ; contour
G1 Y30
G2 X40 Y40 I-10 J0   ; CW corner arc
G1 X10
G3 X0 Y30 I0 J-10    ; CCW corner arc
G1 Y0
G0 Z5

( full circle island at 25,15 r12 )
G0 X37 Y15
G1 Z-1 F150
G2 I-12 J0 F400
G0 Z5

( drill 3 holes with G81 canned cycle )
G81 X10 Y10 Z-6 R2 F100
X25 Y20
X40 Y10
G80
G0 Z25
M30
%`;

export const SAMPLE_TURNING = `%
( Turning demo: face, rough, chamfer, radius, groove )
( X words are diameters; Z runs along the spindle axis )
G21 G90 G18      ; mm, absolute, ZX plane
G99 S1200 M3     ; feed per rev, spindle on
G0 X52 Z2        ; clear the blank

( face off the end )
G0 X-1
G1 Z0 F0.15
G1 X52
G0 Z2

( rough the profile: 2 mm depth of cut, 1 mm retract )
( leaving 0.5 mm on the diameter and 0.1 mm on Z )
G0 X52 Z1
G71 U2.0 R1.0
G71 P100 Q200 U0.5 W0.1 F0.25

( the profile: 2 mm chamfer, ⌀40 shank, 5 mm corner radius, ⌀50 face )
N100 G0 X36
N110 G1 X40 Z-2 F0.12
N120 G1 Z-30
N130 G3 X50 Z-35 I0 K-5   ; CCW corner radius
N200 G1 X52

( finish pass over the same profile )
G70 P100 Q200

( part-off groove at Z-45 )
G0 X54 Z-45
G1 X20 F0.08
G0 X54

G0 X60 Z20
M30
%`;
