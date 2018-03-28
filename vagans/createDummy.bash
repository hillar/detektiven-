#!/bin/bash
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive
apt-get -y install virtinst

DOMAIN=`/bin/hostname -d`
NAME='dummy'
USERNAME='dummy'
PASSWORD='dummy'


[ -f ${USERNAME}.key ] || ssh-keygen -t rsa -N "" -f ./${USERNAME}.key

cat > preseed.cfg <<EOF
# ------------------------------------------------------------------------------
# This preseed file is designed for Ubuntu 16.04 (although it might work
# with other Ubuntu releases as well). It runs unattended, and generates
# a minimal Ubuntu Xenial installation with SSH and not much else.
#
# The installation wipes out anything that might have been on the primary disk
# and repartitions it with LVM and the 'atomic' partition scheme.
#
# Some values of interest:
#        Time zone: UTC
#   Other packages: bash-completion
#           Kernel: linux-virtual
#        Main user: ${USERNAME} (password: ${USERNAME})
#         Hostname: ${NAME}-xenial64
#           Domain: (none)
# ------------------------------------------------------------------------------

# Kernel Selection
d-i base-installer/kernel/override-image string linux-virtual

# Boot Setup
d-i debian-installer/quiet boolean false
d-i debian-installer/splash boolean false
d-i grub-installer/timeout string 2

# Locale Setup
d-i pkgsel/language-pack-patterns string
d-i pkgsel/install-language-support boolean false

d-i debian-installer/language string en
d-i debian-installer/country string US
d-i debian-installer/locale string en_US.UTF-8

# Keyboard Setup
d-i console-setup/ask_detect boolean false
d-i keyboard-configuration/layoutcode string us

# Clock Setup
d-i time/zone string UTC
d-i clock-setup/utc-auto boolean true
d-i clock-setup/utc boolean true
d-i clock-setup/ntp boolean true

# Network Setup
# Note that the hostname and domain also need to be passed as
# arguments on the installer init line.
d-i netcfg/get_hostname string ${NAME}
d-i netcfg/get_domain string ${DOMAIN}
# Choose an network interface that has link if possible.
d-i netcfg/choose_interface select auto

### Mirror settings
d-i mirror/http/countries select EE
d-i mirror/country string EE
d-i mirror/http/hostname string ee.archive.ubuntu.com
d-i mirror/http/directory string /images/Ubuntu/16.04
d-i mirror/http/mirror select ee.archive.ubuntu.com
d-i mirror/http/proxy string

# Drive Setup
d-i grub-installer/only_debian boolean true
d-i partman/unmount_active boolean true
#d-i preseed/early_command string umount /media
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
#d-i partman-auto/disk string /dev/vda
d-i partman-auto/method string lvm
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true
d-i partman-auto-lvm/new_vg_name string primary
d-i partman-auto-lvm/guided_size string max
d-i partman-auto/choose_recipe select atomic
d-i partman/mount_style select uuid
d-i partman/choose_partition select finish

# User Setup
d-i user-setup/allow-password-weak boolean true
d-i passwd/user-fullname string ${USERNAME}
d-i passwd/username string ${USERNAME}

d-i passwd/user-password ${PASSWORD} ${PASSWORD}
d-i passwd/user-password-again ${PASSWORD} ${PASSWORD}
d-i user-setup/allow-password-weak boolean true
d-i user-setup/encrypt-home boolean false

# Repository Setup
d-i apt-setup/restricted boolean true
d-i apt-setup/universe boolean true
d-i apt-setup/backports boolean true

# Do not install recommended packages by default.
d-i base-installer/install-recommends boolean false

# Package Setup
tasksel tasksel/skip-tasks string standard
tasksel tasksel/first multiselect
d-i hw-detect/load_firmware boolean false
d-i pkgsel/update-policy select none
d-i pkgsel/include string openssh-server bash-completion acpi-support wget
d-i pkgsel/upgrade select full-upgrade

# Run postinst.sh in /target just before the install finishes.
d-i preseed/late_command string mkdir -p /target/home/${USERNAME}/.ssh; cp ${USERNAME}.key.pub /target/home/${USERNAME}/.ssh/authorized_keys; echo '${USERNAME} ALL=NOPASSWD:ALL' > /target/etc/sudoers.d/${USERNAME};cp postinstall.sh /target/home/${USERNAME}/; in-target chmod +x /home/${USERNAME}/postinstall.sh
# chmod  0440 sudo
#; in-target /home/${USERNAME}/postinstall.sh > /home/${USERNAME}/postinstall.log 2>&1
#; chmod 700 /target/home/${USERNAME}/.ssh;
#d-i preseed/late_command string chmod 0600 /target/home/${USERNAME}/.ssh/authorized_keys;
#d-i preseed/late_command string chown -R ${USERNAME}:${USERNAME} /target/home/${USERNAME}/.ssh
#in-target bash -x /provision/postinst.sh > /provision/postinst.log 2>&1

# Avoid that last message about the install being complete.
d-i finish-install/reboot_in_progress note
# Perform a poweroff instead of a reboot
d-i debian-installer/exit/poweroff boolean true

EOF

cat > postinstall.sh <<EOF
#!/bin/sh
# Set up sudo
#echo '${USERNAME} ALL=NOPASSWD:ALL' > /etc/sudoers.d/${USERNAME}

sed -i "/[# ]*UseDNS[ \t].*/d" /etc/ssh/sshd_config
echo "UseDNS no" >> /etc/sshd_config

# Cleanup DHCP
if [ -d "/var/lib/dhcp" ]; then
    rm /var/lib/dhcp/*
fi

# Cleanup tmp
rm -rf /tmp/*

# Cleanup apt cache
apt-get -y autoremove --purge
apt-get -y clean
apt-get -y autoclean

# Clean up log files
find /var/log -maxdepth 1 -type f -exec cp /dev/null {} \;
find /var/log/apt -maxdepth 1 -type f -exec cp /dev/null {} \;
find /var/log/fsck -maxdepth 1 -type f -exec cp /dev/null {} \;
journalctl --vacuum-time=1seconds

# Whiteout /boot
dd if=/dev/zero of=/boot/whitespace bs=1M || echo "dd exit code \$? is suppressed"
rm /boot/whitespace

# # Whiteout /
dd if=/dev/zero of=/EMPTY bs=1M  || echo "dd exit code \$? is suppressed"
rm -f /EMPTY

# Make sure we wait until all the data is written to disk
sync
echo "done whiteout"
EOF

source virtHelpers.bash

[ $(vm_is_running ${NAME}) = '0' ] && stop_vm ${NAME}
[ $(vm_exists ${NAME}) = '0' ] && delete_vm ${NAME}


OS_TYPE="linux"
OS_VARIANT="ubuntu16.04"
LOCATION="http://us.archive.ubuntu.com/ubuntu/dists/xenial/main/installer-amd64/"

virt-install \
--connect=qemu:///system \
--name=${NAME} \
--ram=2048 \
--vcpus=2 \
--os-type $OS_TYPE \
--os-variant $OS_VARIANT \
--disk size=16,path=/var/lib/libvirt/images/${NAME}.qcow2,format=qcow2,bus=virtio,cache=none \
--initrd-inject=preseed.cfg \
--initrd-inject=${USERNAME}.key.pub \
--initrd-inject=postinstall.sh \
--location ${LOCATION} \
--virt-type=kvm \
--controller usb,model=none \
--graphics none \
--network network=default,model=virtio \
--wait=-1 \
--noreboot \
--extra-args="auto=true DEBIAN_FRONTEND=text hostname="${NAME}" domain="${DOMAIN}" console=tty0 console=ttyS0,115200n8 serial"

virsh start ${NAME}
ip=$(getip_vm ${NAME})
#ssh-keyscan -H -t rsa ip_or_ipalias  >> ~/.ssh/known_hosts
ssh -oStrictHostKeyChecking=no -i ${USERNAME}.key ${USERNAME}@${ip} "sudo /home/${USERNAME}/postinstall.sh"

[ $(vm_is_running ${NAME}) = '0' ] && stop_vm ${NAME}
imagefile=$(getfile_vm ${NAME})
mv $imagefile $imagefile.backup
time qemu-img convert -O qcow2 -c $imagefile.backup $imagefile
rm $imagefile.backup
